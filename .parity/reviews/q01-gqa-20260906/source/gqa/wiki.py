"""
Wrapper for queries to the Wikipedia API
"""

import datetime
import json
import os
import random
import re
import traceback
import wikipedia

import gqa.config
import gqa.nlp
from gqa.log_helper import generate_logger
LOGGER = generate_logger(__name__)


def normalize_wiki_name(input_name):
    return input_name.lower().replace(" ", "_")


THIS_DIR = os.path.dirname(__file__)
BLACKLIST_FILENAME = os.path.join(THIS_DIR, 'wikipedia_blacklist_complete.json')
with open(BLACKLIST_FILENAME) as blacklist_file:
    BLACKLIST_OBJ = json.load(blacklist_file)
    BLACKLIST_CATEGORIES = [normalize_wiki_name(category) for category in BLACKLIST_OBJ["blacklist_categories"]]
    BLACKLIST_ARTICLES = [normalize_wiki_name(article) for article in BLACKLIST_OBJ["blacklist_articles"]]

# TODO: Interactive disambiguation with the speaker
DISAMBIGUATE_1 = ["I found a few things. Here's one of them. ",
                  "Looks like a few things match what you asked for. Here's my favorite. ",
                  "A few things match what you asked for. "
                  "I'll give you the one at the top of the list. ",
                  "I found more than one thing for that. I'll go with this one. ",
                  "I found a few things for that. I'll tell you about one of them. ",
                  "I found a few things for that. This one in particular seemed interesting. "]


def call(query, question_type):
    '''Public entry point for this file'''
    # query is English text from ASR
    # question_type is "what",  "where", "which", "who", "why", "how", "generic", or ""

    output = {"source": "Wikipedia", "timestamps": {}, "logs": {}}

    # Determine whether Wikipedia can reliably answer this question
    output["timestamps"]["wiki_begin_tokenization"] = int(datetime.datetime.utcnow().timestamp() * 1000)

    strict_query = gqa.nlp.remove_initial_stop_words(query)
    output["logs"]["strict_query"] = strict_query

    LOGGER.debug("Wikipedia strict query: '{0}'".format(strict_query))

    if gqa.wiki.can_answer(query, question_type):
        output["timestamps"]["wiki_request"] = int(datetime.datetime.utcnow().timestamp() * 1000)
        (answer_text, error_messages) = gqa.wiki.search(strict_query)
        output["timestamps"]["wiki_response"] = int(datetime.datetime.utcnow().timestamp() * 1000)
        if answer_text:
            LOGGER.debug("WIKIPEDIA ANSWER TEXT >>> {0} <<<".format(answer_text))
            output["response"] = {
                "type": "string",
                "payload": answer_text
            }
        if error_messages:
            LOGGER.debug("Wikipedia query on '{0}' returned error(s): {1}".format(strict_query,
                                                                                  "\n".join(error_messages)))
            output["message"] = "\n".join(error_messages)
    else:
        # Don't trust Wikipedia to answer this question
        output["message"] = "Blocked by WIKIPEDIA_QUESTION_WORDS restriction."

    return output

def make_comparison_set(text):
    text_working = text.lower()

    # Strip all punctuation to e.g. prevent mismatches between
    # hyphen and emdash, or hyphen and whitespace in compound
    # words
    text_working = re.sub("[^a-z]", " ", text_working)

    return set(text_working.split())


def search(query):
    """The code that actually searches Wikipedia

    :param query: The query phrase (one or more words) that is
        actually sent to the Wikipedia API.  For example: "Toyota
        Camry"
    :return: Tuple, containing two strings:
      0. The first sentence of the English Wikipedia article, or
         the empty string if an answer was not found
      1. List of error message generated during the process, normally empty
    """

    # This is not in the normal place because of threading
    # problems. See: https://github.com/nltk/nltk/issues/947
    from nltk.tokenize import sent_tokenize

    page = "" #I need to use page outside of the try except, need to have a copy here

    if not query:
        return ("", ["Empty query"])

    if normalize_wiki_name(query) in BLACKLIST_ARTICLES:
        return ("", ["Blocked query on '{0}' due to article blacklist".format(query)])

    try:
        wikipedia.set_api_url(gqa.config.CONFIG_DICT["wiki_api"])
        page = wikipedia.WikipediaPage(title=query)
        for category in page.categories:
            if normalize_wiki_name(category) in BLACKLIST_CATEGORIES:
                return("", ["Blocked query on '{0}' due to blacklisted category '{1}'".format(query, category)])

        if any(True for word in ["List of", "Lists of"] if page.title.startswith(word)):
            return ("", ["Blocked query on '{0}' due to title contains word indicating it's list".format(query)])
        # Also contributed to filter out the List answers from Wikipedia, yet this works

        if not page.summary:
            return ("", ["Unexpected empty summary for query '{0}'".format(query)])

        article_wordset = make_comparison_set(page.summary)
        query_wordset = make_comparison_set(query)
        if query_wordset.isdisjoint(article_wordset):
            # High likelihood we've gotten the wrong page
            LOGGER.debug("article_wordset: {0}".format(article_wordset))
            LOGGER.debug("query_wordset: {0}".format(query_wordset))
            return("", ["Query on '{0}' apparently got article on related but different topic".format(query)])

    except wikipedia.exceptions.DisambiguationError as wikierror:

        error_accum = []

        for article_name in wikierror.options:
            if "disambig" in article_name:
                error_accum.append("Skipping disambiguation page {0}".format(article_name))
                continue

            (article_summary, error_sublist) = gqa.wiki.search(article_name)
            if article_summary:
                result = random.choice(DISAMBIGUATE_1) + " " + article_summary
                return (result, [])
            else:
                error_accum.extend(error_sublist)

        return ("", error_accum)

    except wikipedia.exceptions.PageError:
        return ("", ["No match for query '{0}'".format(query)])

    except wikipedia.exceptions.WikipediaException:
        return(
            "",
            ["Wikipedia query '{0}' raised exception in first query stage\n{1}".format(
                query, traceback.format_exc()
            )]
        )

    except Exception: #pylint: disable=broad-except
        error_text = "Wikipedia query '{0}' raised unexpected exception\n{1}".format(
            query, traceback.format_exc()
        )
        LOGGER.error(error_text)
        return("", [error_text])

    text = page.summary
    LOGGER.debug("Text before cleaning: '{0}'".format(text))
    text = gqa.nlp.clean_parentheses(text)
    LOGGER.debug("Text after clean_parentheses(): '{0}'".format(text))
    text = gqa.nlp.normalize_whitespace(text)
    LOGGER.debug("Text after normalize_whitespace(): '{0}'".format(text))

    # Isolate first sentence
    if text:
        sentence_list = sent_tokenize(text)
        if sentence_list:
            result = sentence_list[0]

            if "|" in result or "{" in result or "}" in result:
                return ("", ["Blocked due to apparently broken template"])
            elif result.split()[0] in ["This", "These"] and not any(True for word in ["This", "this", "These", "these"] if word in page.title):
                # To address "This is a list of formerly capitals of India.", "This article lists the heads of state ..."
                # The algorithm is the title started with This, yet the word is not presented in the title
                # The word "This" without context can't be understood
                # https://pvindex.org/jira.jibo.com/browse/JIBO-8031
                return ("", ["Blocked due to answer not suited for speak out"])
            return (result, [])

        return ("", ["Wikipedia response text '{0}' failed sentence segmentation!".format(text)])
    return ("", ["Wikipedia query '{0}' produced empty reply after cleanup!".format(query)])


def can_answer(input_string, question_type):

    """Identify whether the English question in input_string can be
    answered by Wikipedia or suppressed because we might get a
    non-sensical answer back.

    question_type has the same allowed values as call().  Used as a
    hint from Parser service to short-circuit examination of
    input_string if that would be redundant.

    Returns True or False.

    Wikipedia article titles are either nouns or noun phrases, and the
    spoken portion is the first sentence, which by Wikipedia style
    convention should be a concise definition for a general audience.

    Any sentence that has non-stop words other than the article title
    will fail to match.  This prevents "how" and "why" and "which"
    questions from working:

    "How do toilets *work*?" (verb expressing the action that needs explaining)
    "How *long* was the Titanic?" (noun expressing a quantifiable attribute)
    "Why is the sky *blue*?" (condition)
    "Why did the Roman Empire *collapse*?" (verb)
    "Which of the Back Street Boys is *tallest*?" (specifying phrase)
    "Which *way* is north?"

    In other cases, a definition is not a good answer:
    "How is Kesha?"
    "Which is biggest?"

    For certain words, we get mixed good and bad answers:
    # When is breakfast?  (good - definition includes time-of-day information)
    # When is the next election?  (bad - "An election is a formal group decision-making process..."

    Examples that justify the other words:
    # What is rain?
    # Who is Wolfgang Pauli?
    # Where is Guatamala?  (geographical information is commonly included in the definition)

    """

    # See if Parser service has pre-determined the type of question
    if question_type:
        if question_type in gqa.nlp.WIKIPEDIA_QUESTION_WORDS:
            return True
        if question_type != "generic":
            # Something like "how", that Wikipedia affirmatively cannot answer
            return False

    # For "" and "generic", Parser couldn't decide on the specific
    # question type, so fall through to do that on our own...

    # Look at the actual input_string
    working_string = gqa.nlp.normalize_whitespace(input_string)
    word_list = working_string.lower().split(" ")
    for word in word_list:
        if word in gqa.nlp.WIKIPEDIA_QUESTION_WORDS:
            return True
    return False
