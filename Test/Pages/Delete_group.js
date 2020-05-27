class Delete_grouppage{
    get welcomegroup(){
         return $("(//span[text()='Welcome To Group'])[1]")
        
    }
    get joinedgroup(){
        return $("//a[@id='u_fetchstream_7_e']").selectByIndex(1)
    }

    get leavegroup(){
        return $("//button[@type='submit' and @name='confirmed']")
    }

    get closegroup(){
        return $("//div[text()='Close']")
    }

}

module.exports=new Delete_grouppage()



// return $("(//span[text()='Welcome To Group'])[1]")