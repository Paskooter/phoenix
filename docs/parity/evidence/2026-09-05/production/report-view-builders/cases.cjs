exports.cases=function(){
 const rows=[];for(const celsius of [false,true])for(const high of [-10,-9,0,9,10,40,85,86,99,100])rows.push({kind:'weather',args:[{highTemp:high,lowTemp:high-12,icon:'clear-day'},celsius]});
 for(const extra of [-1,0,4.9,5,14.9,15,60])rows.push({kind:'traffic',args:[extra]});
 for(const time of ['12:00 AM','8:05 AM','1:00 PM','11:59 PM'])rows.push({kind:'depart',args:[{departDT:{time:time}}]});
 for(const size of [[600,1000],[1280,720],[2000,720],[500,500],[300,200]])rows.push({kind:'news',args:[['strange','sports'].map((category,i)=>({category:category,headline:'Source review '+i,image:{source:'http://fixture.invalid/image-'+i+'.jpg',width:String(size[0]),height:String(size[1])}}))]});
 for(const hour of [0,11,12,18,19,23])for(const fullDay of [false,true])for(const minute of [0,25])rows.push({kind:'calendar',args:[[{summary:'Birthday party and board meeting '+'.'.repeat(30),fullDay:fullDay,dateTime:{hour:hour,minute:minute,time:(hour%12||12)+':'+(minute?'25':'00')+' '+(hour>=12?'PM':'AM')}}],{skill:{session:{data:{_personalReport:{singleSkill:'calendar'}}}}}]});
 rows.push({kind:'calendar',args:[[null,{summary:'Lunch',fullDay:true,dateTime:{hour:12,minute:0,time:'12:00 PM'}}],{skill:{session:{data:{_personalReport:{singleSkill:'calendar'}}}}}]});return rows;
};
exports.argumentsFor=function(row){const args=JSON.parse(JSON.stringify(row.args));if(row.kind==='depart')args[0].departDT={toString:function(){return row.args[0].departDT.time;}};if(row.kind==='calendar')args[0].forEach(function(e){if(e){const d=e.dateTime;e.dateTime={getLocalTime:function(){return {hour:d.hour,minute:d.minute};},toString:function(){return d.time;}};}});return args;};
